import { Stack, StackProps, Tags, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as custom from 'aws-cdk-lib/custom-resources';


export class GovernanceStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    //cloudtrail for this single account since we arent using orgs
    const trailBucket = new s3.Bucket(this, 'TrailBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(365) }],
    });

    new cloudtrail.Trail(this, 'AccountTrail', {
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      bucket: trailBucket,
      enableFileValidation: true,
    });

    //guardduty with some basic standards
    new guardduty.CfnDetector(this, 'GuardDutyDetector', { enable: true });

    const hub = new securityhub.CfnHub(this, 'SecurityHub');

    const region = Stack.of(this).region;
    const afsArn = `arn:aws:securityhub:${region}::standards/aws-foundational-security-best-practices/v/1.0.0`;

    new custom.AwsCustomResource(this, 'EnableAFSBP', {
      onCreate: {
        service: 'SecurityHub',
        action: 'batchEnableStandards',
        parameters: {
          StandardsSubscriptionRequests: [{ StandardsArn: afsArn }],
        },
        physicalResourceId: custom.PhysicalResourceId.of('AFSBP-once'),
        ignoreErrorCodesMatching: 'ResourceConflictException',
      },
      onUpdate: {
        service: 'SecurityHub',
        action: 'batchEnableStandards',
        parameters: {
          StandardsSubscriptionRequests: [{ StandardsArn: afsArn }],
        },
        physicalResourceId: custom.PhysicalResourceId.of('AFSBP-once'),
        ignoreErrorCodesMatching: 'ResourceConflictException',
      },
      policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
        resources: custom.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    }).node.addDependency(hub);


    //basic cost budget
    //update email when production email is known
    const budgetEmail =
      this.node.tryGetContext('budgetEmail') ?? 'owner@example.com';

    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 50, unit: 'USD' },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: 'GREATER_THAN',
            thresholdType: 'PERCENTAGE',
            threshold: 80,
            notificationType: 'ACTUAL',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: budgetEmail,
            },
          ],
        },
      ],
    });

    //tag everything
    Tags.of(this).add('Compliance', 'Baseline');
  }
}
