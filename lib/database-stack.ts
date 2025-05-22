import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface DatabaseStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class DatabaseStack extends cdk.Stack {
  public readonly dbSecret: secretsmanager.Secret;
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    this.dbSecret = new secretsmanager.Secret(this, 'WordpressDbSecret', {
      secretName: 'wordpress-db-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'wordpress',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        includeSpace: false,
      },
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: props.vpc,
      description: 'MySQL ingress only from app tier',
    });

    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(3306),
      'MySQL from inside VPC',
    );

    //Creating a multi zone RDS database. This is defined with a very small instance that can be updated if needed
    this.dbInstance = new rds.DatabaseInstance(this, 'WordpressRDS', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: new ec2.InstanceType('t4g.small'),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: 'wordpress',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      multiAz: true,
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      deleteAutomatedBackups: false,
      backupRetention: cdk.Duration.days(14),
      securityGroups: [this.dbSecurityGroup],
    });

  }
}