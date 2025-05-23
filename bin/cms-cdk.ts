#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GovernanceStack } from '../lib/governance-stack';
import { NetworkStack } from '../lib/network-stack';
import { EcsStack } from '../lib/ecs-stack';
import { DatabaseStack } from '../lib/database-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new cdk.App();

//Certificates need to exist in the account for the domain name defined here.
const domainName = 'domain.com';
const cfCertificateArn = 'arn:aws:acm:us-east-1:';
const originCertificateArn = 'arn:aws:acm:ap-southeast-2:';

const sydEnv = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: 'ap-southeast-2' 
};

const usEnv = { 
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: 'us-east-1' 
};

const govStack = new GovernanceStack(app, 'GovernanceStack', {
   env: sydEnv 
  });

const networkStack = new NetworkStack(app, 'CmsNetworkStack', {
  env: sydEnv
});
networkStack.addDependency(govStack);

const dbStack = new DatabaseStack(app, 'CmsDatabaseStack', {
  vpc: networkStack.vpc,
  env: sydEnv,
});

const ecsStack = new EcsStack(app, 'CmsEcsStack', {
  vpc: networkStack.vpc,
  dbSecret: dbStack.dbSecret,
  dbInstance: dbStack.dbInstance,
  domainName: domainName,
  originCertArn: originCertificateArn,
  crossRegionReferences: true,
  env:sydEnv,
});

const edge = new EdgeStack(app, 'CmsEdgeStack', {
  loadBalancerDnsName: ecsStack.loadBalancerDnsName,
  domainName: domainName,
  cfCertificateArn: cfCertificateArn,
  crossRegionReferences: true,
  env: usEnv,
});
edge.addDependency(ecsStack);  