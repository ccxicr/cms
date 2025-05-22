import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import {
  Distribution,
  AllowedMethods,
  CachePolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
  OriginProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';

export interface EdgeStackProps extends cdk.StackProps {
  loadBalancerDnsName: string;  // should be origin.<domain>
  domainName: string;
  cfCertificateArn: string;
}

export class EdgeStack extends cdk.Stack {
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    // Lookup existing hosted zone
    const zone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: props.domainName,
    });

    // Bucket for CloudFront access logs
    const logBucket = new s3.Bucket(this, 'CloudFrontLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // Viewer cert for CloudFront
    const viewerCert = certificatemanager.Certificate.fromCertificateArn(
      this,
      'ViewerCert',
      props.cfCertificateArn
    );

    // WAF ACL for CloudFront
    const webAcl = new wafv2.CfnWebACL(this, 'WpWebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        metricName: 'WpWebAcl',
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            metricName: 'Common',
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
          },
        },
        {
          name: 'RateLimit1k5m',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            metricName: 'RateLimit',
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
          },
        },
      ],
    });

    // Origin: custom domain over HTTPS
    const origin = new origins.HttpOrigin(props.loadBalancerDnsName, {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
    });

    // Behavior for wp-admin & login pages
    const adminBehavior = {
      origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
    };

    // Create CloudFront distribution
    this.distribution = new Distribution(this, 'WordpressCdn', {
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
      },
      additionalBehaviors: {
        'wp-login.php': adminBehavior,
        'wp-admin/install.php': adminBehavior,
        'wp-admin/*': adminBehavior,
      },
      domainNames: [props.domainName],
      certificate: viewerCert,
      webAclId: webAcl.attrArn,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableLogging: true,
      logBucket,
      logFilePrefix: 'cloudfront',
    });

    // DNS records for CloudFront
    new route53.ARecord(this, 'ApexAlias', {
        zone,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution),
        ),
      });
      new route53.AaaaRecord(this, 'ApexAliasAAAA', {
        zone,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution),
        ),
      });

    // Output distribution domain
    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution hostname',
    });
  }
}
