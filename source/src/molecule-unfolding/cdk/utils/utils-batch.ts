import * as batch from '@aws-cdk/aws-batch-alpha'
import * as cdk from 'aws-cdk-lib'
import {
    aws_ec2 as ec2
} from 'aws-cdk-lib'

import {
    aws_iam as iam
} from 'aws-cdk-lib'

import {
    aws_ecs as ecs
} from 'aws-cdk-lib'

import {
    aws_s3 as s3
} from 'aws-cdk-lib'

import {
    RoleUtil
} from './utils-role'

import {
    ECRRepoNameEnum,
    ECRImageUtil
} from './utils-images'

import {
    Construct
} from 'constructs'

interface Props {
    region: string;
    account: string;
    prefix: string;
    bucket: s3.Bucket;
    vpc: ec2.Vpc;
    batchSg: ec2.SecurityGroup

}
export class BatchUtil {
    private props: Props
    private scope: Construct
    private batchJobExecutionRole: iam.Role
    private hpcBatchJobRole: iam.Role
    private qcBatchJobRole: iam.Role
    private createModelBatchJobRole: iam.Role
    private hpcJobQueue: batch.JobQueue
    private fargateJobQueue: batch.JobQueue
    private imageUtil : ECRImageUtil

    private constructor(scope: Construct, props: Props, utils: {
        roleUtil: RoleUtil,
        imageUtil: ECRImageUtil
    }) {
        this.props = props
        this.scope = scope 
        this.imageUtil = utils.imageUtil
        this.batchJobExecutionRole = utils.roleUtil.createBatchJobExecutionRole('batchExecutionRole');
        this.hpcBatchJobRole = utils.roleUtil.createHPCBatchJobRole('hpcBatchJobRole');
        this.qcBatchJobRole = utils.roleUtil.createQCBatchJobRole('qcBatchJobRole');
        this.createModelBatchJobRole = utils.roleUtil.createCreateModelBatchJobRole('createModelBatchJobRole');
        this.hpcJobQueue = this.setUpHPCBashEnv()
        this.fargateJobQueue = this.setUpFargateBashEnv()
    }
    public static newInstance(scope: Construct, props: Props, utils: {
        roleUtil: RoleUtil,
        imageUtil: ECRImageUtil
    }) {
        return new this(scope, props, utils);
    }

    private setUpHPCBashEnv(): batch.JobQueue {
        const hpcIstanceTypes = [
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.LARGE), // 2 vcpus, 4G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE), // 4 vcpus, 8G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE2), // 8 vcpus, 16G mem
            ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE4), // 16 vcpus, 32G mem
            //ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE9), // 36 vcpus, 72 mem
        ];
        const vpc = this.props.vpc
        const batchSg = this.props.batchSg

        const batchHPCEnvironment = new batch.ComputeEnvironment(this.scope, 'Batch-HPC-Compute-Env', {
            computeResources: {
                type: batch.ComputeResourceType.ON_DEMAND,
                vpc,
                vpcSubnets: vpc.selectSubnets({
                    subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
                }),
                allocationStrategy: batch.AllocationStrategy.BEST_FIT,
                instanceTypes: hpcIstanceTypes,
                securityGroups: [batchSg]
            }
        });

        return new batch.JobQueue(this.scope, 'hpcJobQueue', {
            computeEnvironments: [{
                computeEnvironment: batchHPCEnvironment,
                order: 1,
            }, ],
        })
    }

    private setUpFargateBashEnv(): batch.JobQueue {
        const vpc = this.props.vpc
        const batchSg = this.props.batchSg

        const batchFargateEnvironment = new batch.ComputeEnvironment(this.scope, 'Batch-Fargate-Compute-Env', {
            computeResources: {
                type: batch.ComputeResourceType.FARGATE,
                vpc,
                vpcSubnets: vpc.selectSubnets({
                    subnetType: ec2.SubnetType.PRIVATE_WITH_NAT
                }),
                securityGroups: [batchSg]
            }
        });

        return new batch.JobQueue(this.scope, 'fargateJobQueue', {
            computeEnvironments: [{
                computeEnvironment: batchFargateEnvironment,
                order: 1,
            }, ],
        })
    }

    public getHpcJobQueue(): batch.JobQueue {
        return this.hpcJobQueue
    }

    public getFargateJobQueue(): batch.JobQueue {
        return this.fargateJobQueue
    }

    public createCreateModelJobDef(): batch.JobDefinition {

        const image = this.imageUtil.getECRImage(ECRRepoNameEnum.Batch_Create_Model) as ecs.ContainerImage
        const vcpus = 2
        const mem = 4
        const resource = this.getResourceDescription(vcpus, mem)

        return new batch.JobDefinition(this.scope, 'CreateModelJobDef', {
            platformCapabilities: [batch.PlatformCapabilities.FARGATE],
            container: {
                image,
                command: [
                    '--aws-region', this.props.region,
                    '--resource', `${resource}`,
                    '--s3-bucket', this.props.bucket.bucketName,
                ],
                executionRole: this.batchJobExecutionRole,
                jobRole: this.createModelBatchJobRole,
                vcpus,
                memoryLimitMiB: mem * 1024,
                privileged: false
            },
            timeout: cdk.Duration.hours(2),
            retryAttempts: 1
        });
    }
    
    public createHPCBatchJobDef(defName: string, vcpus: number, mem: number): batch.JobDefinition {

        const image = this.imageUtil.getECRImage(ECRRepoNameEnum.Batch_Sa_Optimizer) as ecs.ContainerImage
        const resource = this.getResourceDescription(vcpus, mem)

        return new batch.JobDefinition(this.scope, defName, {
            platformCapabilities: [batch.PlatformCapabilities.EC2],
            container: {
                image,
                command: [
                    '--model-param', 'M=1&D=4&A=300&HQ=200',
                    '--aws-region', this.props.region,
                    '--resource', `${resource}`,
                    '--s3-bucket', this.props.bucket.bucketName,
                ],
                executionRole: this.batchJobExecutionRole,
                jobRole: this.hpcBatchJobRole,
                vcpus,
                memoryLimitMiB: mem * 1024,
                privileged: false
            },
            timeout: cdk.Duration.hours(6),
            retryAttempts: 1
        });

    }

    public createQCSubmitBatchJobDef(defName: string): batch.JobDefinition {

        const image = this.imageUtil.getECRImage(ECRRepoNameEnum.Batch_Qa_Optimizer) as ecs.ContainerImage
        const vcpus = 2
        const mem = 4
        const resource = this.getResourceDescription(vcpus, mem)

        return new batch.JobDefinition(this.scope, defName, {
            platformCapabilities: [batch.PlatformCapabilities.FARGATE],
            container: {
                image,
                command: [
                    '--model-param', 'M=1&D=4&A=300&HQ=200',
                    '--aws-region', this.props.region,
                    '--resource', `${resource}`,
                    '--s3-bucket', this.props.bucket.bucketName,
                ],
                executionRole: this.batchJobExecutionRole,
                jobRole: this.qcBatchJobRole,
                vcpus,
                memoryLimitMiB: mem * 1024,
                privileged: false
            },
            timeout: cdk.Duration.hours(1),
            retryAttempts: 1
        });
    }

    private getResourceDescription(vcpus: number, mem: number): string {
        return `vCpus${vcpus}_Mem_${mem}G`;
    }
}