import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as path from 'node:path';
import { Construct } from 'constructs';

const VALID_LOG_RETENTION_DAYS = new Set([
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096,
  1827, 2192, 2557, 2922, 3288, 3653,
]);

export interface PortalApiStackProps extends cdk.StackProps {
  apiName: string;
  functionName: string;
  allowedOrigins: string[];
  alarmTopicArn: string;
  memoryMb?: number;
  timeoutSeconds?: number;
  provisionedConcurrency?: number;
  logRetentionDays?: number;
  secretNames?: string[];
  environment?: Record<string, string>;
}

export class PortalApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PortalApiStackProps) {
    super(scope, id, props);

    const {
      apiName,
      functionName,
      allowedOrigins,
      alarmTopicArn,
      memoryMb = 512,
      timeoutSeconds = 30,
      provisionedConcurrency = 0,
      logRetentionDays = 30,
      secretNames = [],
      environment = {},
    } = props;

    if (allowedOrigins.length === 0) {
      throw new Error('allowedOrigins must contain at least one explicit origin');
    }
    if (allowedOrigins.includes('*')) {
      throw new Error('allowedOrigins cannot contain a wildcard origin');
    }
    if (memoryMb < 128 || memoryMb > 10_240) {
      throw new Error('memoryMb must be between 128 and 10240');
    }
    if (timeoutSeconds < 1 || timeoutSeconds > 900) {
      throw new Error('timeoutSeconds must be between 1 and 900');
    }
    if (provisionedConcurrency < 0) {
      throw new Error('provisionedConcurrency cannot be negative');
    }
    if (!VALID_LOG_RETENTION_DAYS.has(logRetentionDays)) {
      throw new Error('logRetentionDays must be a supported CloudWatch value');
    }

    const logGroup = new logs.LogGroup(this, 'PortalApiLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logRetentionDays as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const handler = new nodejs.NodejsFunction(this, 'PortalApiFunction', {
      functionName,
      entry: path.join(__dirname, '../../src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler',
      memorySize: memoryMb,
      timeout: cdk.Duration.seconds(timeoutSeconds),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        ...environment,
        NODE_OPTIONS: '--enable-source-maps',
        POWERTOOLS_SERVICE_NAME: apiName,
        POWERTOOLS_METRICS_NAMESPACE: apiName,
        POWERTOOLS_LOG_LEVEL: 'INFO',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
      },
    });

    const executionTarget: lambda.IFunction =
      provisionedConcurrency > 0
        ? new lambda.Alias(this, 'LiveAlias', {
            aliasName: 'live',
            version: handler.currentVersion,
            provisionedConcurrentExecutions: provisionedConcurrency,
          })
        : handler;

    for (const [index, secretName] of secretNames.entries()) {
      const secret = secretsmanager.Secret.fromSecretNameV2(
        this,
        `PortalSecret${index}`,
        secretName,
      );
      secret.grantRead(executionTarget);
    }

    const httpApi = new apigwv2.HttpApi(this, 'PortalHttpApi', {
      apiName,
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
      },
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'PortalLambdaIntegration',
      executionTarget,
    );

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    const durationAlarm = new cloudwatch.Alarm(this, 'DurationAlarm', {
      metric: executionTarget.metricDuration({
        statistic: 'p95',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 200,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Portal API Lambda p95 duration is at least 200 ms',
    });

    const errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      metric: executionTarget.metricErrors({
        statistic: 'sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Portal API Lambda reported one or more errors',
    });

    const apiDimensions = {
      ApiId: httpApi.apiId,
      Stage: '$default',
    };
    const apiLatencyAlarm = new cloudwatch.Alarm(this, 'ApiLatencyAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Latency',
        dimensionsMap: apiDimensions,
        statistic: 'p95',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 200,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Portal HTTP API p95 latency is at least 200 ms',
    });
    const http5xxAlarm = new cloudwatch.Alarm(this, 'Http5xxAlarm', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: apiDimensions,
        statistic: 'sum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Portal HTTP API reported one or more 5xx responses',
    });

    if (!alarmTopicArn.startsWith('SECRET_PLACEHOLDER_')) {
      const alarmTopic = sns.Topic.fromTopicArn(
        this,
        'PortalAlarmTopic',
        alarmTopicArn,
      );
      const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
      for (const alarm of [
        durationAlarm,
        errorAlarm,
        apiLatencyAlarm,
        http5xxAlarm,
      ]) {
        alarm.addAlarmAction(alarmAction);
      }
    }

    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'FunctionName', {
      value: executionTarget.functionName,
    });
  }
}
