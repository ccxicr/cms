import * as cdk from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  dbSecret: secrets.ISecret;
  dbInstance: rds.IDatabaseInstance;
  domainName: string;
  originCertArn: string;
}

export class EcsStack extends cdk.Stack {
  public readonly loadBalancerDnsName: string;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    // Lookup hosted zone for origin certificate validation & DNS
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.domainName,
    });

    // Import existing ACM certificate for origin.<domain>
    const originCert = cm.Certificate.fromCertificateArn(
      this,
      'OriginCert',
      props.originCertArn,
    );

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'CmsCluster', { vpc: props.vpc });

    // Logs and buckets
    const wpLogGroup = new logs.LogGroup(this, 'WordPressLogs', { retention: logs.RetentionDays.ONE_WEEK });

    const albLogBucket = new s3.Bucket(this, 'AlbLogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // CloudFront prefix list for origin SG
    const cloudFrontPeer = ec2.Peer.prefixList('pl-b8a742d1');

    // ALB Security Group: HTTPS only from CloudFront, egress HTTP to tasks
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'ALB inbound HTTPS from CloudFront only',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(cloudFrontPeer, ec2.Port.tcp(443), 'CloudFront HTTPS');
    albSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'To tasks HTTP');

    // Task SG: allow inbound from ALB on HTTP, restricted egress
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: props.vpc,
      description: 'Fargate tasks inbound from ALB over HTTP',
      allowAllOutbound: false,
    });
    taskSg.addIngressRule(albSg, ec2.Port.tcp(80), 'ALB to tasks');
    // RDS
    taskSg.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(3306),
      'MySQL inside VPC'
    );
    // External HTTPS
    taskSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    // EFS NFS
    taskSg.addEgressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      'EFS NFS'
    );

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'WpAlb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // HTTPS listener with imported cert
    const httpsListener = alb.addListener('Https', {
      port: 443,
      certificates: [originCert],
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      open: false,
    });

    // Route53 alias for origin.<domain>
    new route53.ARecord(this, 'OriginAlias', {
      zone: hostedZone,
      recordName: 'origin',
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
    });

    // Target group: HTTP on port 80
    const tg = new elbv2.ApplicationTargetGroup(this, 'WpTg', {
      vpc: props.vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(30),
      },
    });
    httpsListener.addTargetGroups('WpTargets', { targetGroups: [tg] });

    tg.enableCookieStickiness(Duration.hours(1));

    alb.logAccessLogs(albLogBucket, 'alb');
    this.loadBalancerDnsName = `origin.${props.domainName}`;

    // EFS for wp-content
    const fileSystem = new efs.FileSystem(this, 'WpFs', {
      vpc: props.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const accessPoint = fileSystem.addAccessPoint('WpAp', {
      path: '/wordpress/wp-content',
      posixUser: { uid: '33', gid: '33' },
      createAcl: { ownerUid: '33', ownerGid: '33', permissions: '755' },
    });

    // Fargate Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    //wordpress should really be in our own ECR rather than a public registry
    const container = taskDef.addContainer('WordPress', {
      image: ecs.ContainerImage.fromRegistry('wordpress:6.8.1'),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'wp', logGroup: wpLogGroup }),
      secrets: {
        WORDPRESS_DB_USER: ecs.Secret.fromSecretsManager(props.dbSecret, 'username'),
        WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbSecret, 'password'),
      },
      environment: {
        WORDPRESS_DB_HOST: props.dbInstance.dbInstanceEndpointAddress,
        WORDPRESS_DB_NAME: 'wordpress',
        WORDPRESS_CONFIG_EXTRA: [
          `define('WP_HOME','https://${props.domainName}');`,
          `define('WP_SITEURL','https://${props.domainName}');`,
          `if(isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO']==='https'){`,
          `  $_SERVER['HTTPS']='on';`,
          `}`,
        ].join('\n'),
      },
    });
    container.addPortMappings({ containerPort: 80 });

    // Mount EFS volume
    taskDef.addVolume({
      name: 'wp-content',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
      },
    });
    container.addMountPoints({
      containerPath: '/var/www/html/wp-content',
      sourceVolume: 'wp-content',
      readOnly: false,
    });

    // Fargate Service
    const service = new ecs.FargateService(this, 'WpService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      securityGroups: [taskSg],
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // Permissions
    fileSystem.connections.allowDefaultPortFrom(service);
    fileSystem.grantReadWrite(taskDef.taskRole);
    tg.addTarget(service);

    // Auto-scaling
    const scaling = service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization('Cpu55', {
      targetUtilizationPercent: 55,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    new cdk.CfnOutput(this, 'OriginDomain', {
      value: this.loadBalancerDnsName,
      description: 'Custom origin domain for CloudFront',
    });
  }
}
