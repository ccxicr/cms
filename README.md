# WordPress on ECS with AWS CDK

## Overview

This repository contains an AWS CDK project written in TypeScript that deploys a WordPress site on Amazon ECS Fargate. The setup covers networking, governance guardrails, database provisioning, application services, and edge delivery via CloudFront. Although the foundation of the project is fully established, this is in no way complete for a full production roll out until the limitations below are addressed. 

## Limitations

Although this stack does deploy a resonably complete multi AZ solution, there are still many limitations due to severe time constraints. These can all be addressed reasonably quickly with a bit more time. They are not limited to but including:

### Observability
* No CloudWatch dashboards for ECS, ALB or RDS
* No alarms on CPU, memory, error rates, database connections or request latency

### Logging
* No VPC flow logs
* Log group retentions are not set high enough for real production

### Backup
* RDS snapshots live only in one region
* No cross-region or cross-account copy of database backups

### High availability
* No RDS read replicas for read-heavy workloads
* ECS deploys rolling updates only, no blue-green or canary deployment strategy

### Security enhancements
* Secrets Manager credentials lack automatic rotation
* Container images come straight from Docker Hub with no vulnerability scan
* IAM roles and policies could be tightened to enforce least privilege

### Compliance and drift detection
* No AWS Config rules or detection alerts
* Only a generic compliance tag is applied

### CI/CD and automated testing
* No pipeline to build, test and deploy changes
* No linting or security checks before deployment


## Prerequisites

* Node.js 14.x or later
* AWS CDK v2.x installed (`npm install -g aws-cdk`)
* AWS CLI configured with appropriate credentials and default region

## Getting Started

1. **Clone the repo**

   ```bash
   git clone https://github.com/ccxicr/cms.git
   cd cms
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Bootstrap your AWS environment** (if you have not done so)

    This requires both ap-southeast-2 and us-east-1 regions.

   ```bash
   cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
   ```

4. **Manual configuration**

    A domain name and Certs must be created, the certs need to be in both regions. In the cloudfront region (us-east-1) just the top level domain cert is required. In the ap-southeast-2 an origin.domain.com cert is required. ARNs should be added to the cms-cdk.ts. The code could be modified to handle this more grecefully.

5. **Deploy the stacks**

   Deploy each stack in order:

   ```bash
   cdk deploy NetworkStack
   cdk deploy GovernanceStack
   cdk deploy DatabaseStack
   cdk deploy EcsStack
   cdk deploy EdgeStack
   ```

   You can also deploy all at once:

   ```bash
   cdk deploy --all
   ```

## Project Structure

```
├── bin
│   └── cms-cdk.ts          # CDK app entry point
├── lib
│   ├── network-stack.ts    # VPC, subnets, security groups
│   ├── governance-stack.ts # Guardrails: Config, CloudTrail, IAM rules
│   ├── database-stack.ts   # RDS provision
│   ├── ecs-stack.ts        # ECS cluster, service, task definitions
│   └── edge-stack.ts       # CloudFront distribution and SSL
├── cdk.json                # CDK configuration
├── package.json            # npm dependencies and scripts
├── tsconfig.json           # TypeScript compiler settings
└── README.md               # Project overview and instructions
```

## Stacks Details

* **NetworkStack**: Creates a VPC with public and private subnets, NAT gateways, and security groups for ECS and database.

* **GovernanceStack**: Sets up AWS Config rules, CloudTrail logs, and IAM policies to enforce best practices.

* **DatabaseStack**: Provisions an RDS MySQL cluster to host the WordPress database. Credentials are stored in AWS Secrets Manager.

* **EcsStack**: Defines an ECS cluster on Fargate, creates a task definition for WordPress containers, and configures an Application Load Balancer.

* **EdgeStack**: Deploys a CloudFront distribution in front of the load balancer and manages DNS records in Route 53.

## Common Commands

* **Synthesize CloudFormation**

  ```bash
  cdk synth
  ```

* **View diff before deploy**

  ```bash
  cdk diff
  ```

* **Destroy all resources**

  ```bash
  cdk destroy --all
  ```

## Cleanup

To avoid ongoing charges, destroy all stacks when you are finished:

```bash
cdk destroy --all
```
