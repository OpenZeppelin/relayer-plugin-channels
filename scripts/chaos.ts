/*
 Channel Accounts Plugin — SQS Chaos Script (staging)

 What it does
 - Triggers traffic via app smoke flow (default) or direct SQS poison injection (optional)
 - Polls source queue + DLQ approximate depths
 - Scans ECS CloudWatch logs for queue/send-message failures
 - Optionally starts DLQ redrive back to source queue

 Requirements
 - AWS CLI v2 configured in shell (valid credentials/session)
 - Access to SQS + CloudWatch Logs for target resources

 Examples

   # Full run via app traffic: trigger -> observe -> redrive -> observe
   tsx scripts/chaos.ts \
     --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/stellar-tx-status-check.fifo \
     --dlq-url https://sqs.us-east-1.amazonaws.com/123456789012/stellar-tx-status-check-dlq.fifo \
     --region us-east-1 \
     --log-group /aws/ecs/relayer-channels-stg/task \
     --trigger app \
     --smoke-args "--api-key <KEY> --base-url https://<RELAYER_URL> --plugin-id channels --test-id xdr-payment --concurrency 5" \
     --wait-seconds 180 \
     --phase full

   # Only inject poison messages directly (optional mode)
   tsx scripts/chaos.ts --queue-url ... --phase inject --messages 10

   # Observe queue depths + logs only
   tsx scripts/chaos.ts --queue-url ... --dlq-url ... --phase observe --wait-seconds 300

   # Redrive DLQ manually
   tsx scripts/chaos.ts --queue-url ... --dlq-url ... --phase redrive
*/

import { execFileSync } from 'child_process';

type ArgMap = Record<string, string | boolean>;

type QueueStats = {
  visible: number;
  inFlight: number;
  delayed: number;
};

type LogEvent = {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
};

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.includes('=') ? a.split('=') : [a, undefined];
    const key = k.replace(/^--/, '').trim();
    if (v !== undefined) out[key] = v;
    else {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function asString(value: string | boolean | undefined, fallback?: string): string {
  if (typeof value === 'string') return value;
  if (fallback !== undefined) return fallback;
  return '';
}

function asInt(value: string | boolean | undefined, fallback: number): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(raw) ? raw : fallback;
}

function asBool(value: string | boolean | undefined): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function runAwsJson(args: string[]): unknown {
  const out = execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function runAwsText(args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getQueueStats(region: string, queueUrl: string): QueueStats {
  const raw = runAwsJson([
    'sqs',
    'get-queue-attributes',
    '--region',
    region,
    '--queue-url',
    queueUrl,
    '--attribute-names',
    'ApproximateNumberOfMessages',
    'ApproximateNumberOfMessagesNotVisible',
    'ApproximateNumberOfMessagesDelayed',
  ]) as {
    Attributes?: Record<string, string>;
  };

  const attrs = raw.Attributes || {};
  return {
    visible: Number.parseInt(attrs.ApproximateNumberOfMessages || '0', 10),
    inFlight: Number.parseInt(attrs.ApproximateNumberOfMessagesNotVisible || '0', 10),
    delayed: Number.parseInt(attrs.ApproximateNumberOfMessagesDelayed || '0', 10),
  };
}

function queueArn(region: string, queueUrl: string): string {
  const raw = runAwsJson([
    'sqs',
    'get-queue-attributes',
    '--region',
    region,
    '--queue-url',
    queueUrl,
    '--attribute-names',
    'QueueArn',
  ]) as {
    Attributes?: Record<string, string>;
  };

  const arn = raw.Attributes?.QueueArn;
  if (!arn) throw new Error(`QueueArn not found for ${queueUrl}`);
  return arn;
}

function isFifo(queueUrl: string): boolean {
  return queueUrl.endsWith('.fifo');
}

function sendPoisonMessages(region: string, queueUrl: string, messages: number, chaosId: string): void {
  const fifo = isFifo(queueUrl);
  for (let i = 0; i < messages; i++) {
    const payload = `CHAOS_POISON::${chaosId}::${i}::${Date.now()}::NOT_JSON`;
    const args = ['sqs', 'send-message', '--region', region, '--queue-url', queueUrl, '--message-body', payload];

    if (fifo) {
      args.push('--message-group-id', `chaos-${chaosId}`);
      args.push('--message-deduplication-id', `${chaosId}-${i}-${Date.now()}`);
    }

    runAwsText(args);
    console.log(`   injected poison message ${i + 1}/${messages}`);
  }
}

function parseShellArgs(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function runSmoke(smokeArgs: string): void {
  const argv = ['dlx', 'tsx', 'scripts/smoke.ts', ...parseShellArgs(smokeArgs)];
  execFileSync('pnpm', argv, { stdio: 'inherit' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRecentQueueErrorLogs(region: string, logGroup: string, startTimeMs: number, limit = 500): LogEvent[] {
  const raw = runAwsJson([
    'logs',
    'filter-log-events',
    '--region',
    region,
    '--log-group-name',
    logGroup,
    '--start-time',
    String(startTimeMs),
    '--limit',
    String(limit),
  ]) as {
    events?: LogEvent[];
  };

  const patterns = [
    'Status check queue push failed',
    'Queue error:',
    'SendMessage failed',
    'sendMessage',
    'SQS error',
  ];

  return (raw.events || []).filter((e) => {
    const msg = e.message || '';
    return patterns.some((p) => msg.includes(p));
  });
}

async function observe(
  region: string,
  queueUrl: string,
  dlqUrl: string | undefined,
  logGroup: string,
  waitSeconds: number,
  pollSeconds: number,
  startTimeMs: number
): Promise<void> {
  const polls = Math.max(1, Math.floor(waitSeconds / pollSeconds));

  for (let i = 0; i < polls; i++) {
    const src = getQueueStats(region, queueUrl);
    const dlq = dlqUrl ? getQueueStats(region, dlqUrl) : undefined;

    const seconds = (i + 1) * pollSeconds;
    const summary = [`t+${seconds}s`, `source(v=${src.visible}, inFlight=${src.inFlight}, delayed=${src.delayed})`];
    if (dlq) summary.push(`dlq(v=${dlq.visible}, inFlight=${dlq.inFlight}, delayed=${dlq.delayed})`);

    console.log(`   ${summary.join(' | ')}`);

    await sleep(pollSeconds * 1000);
  }

  const errors = getRecentQueueErrorLogs(region, logGroup, startTimeMs);
  console.log('\nCloudWatch queue-related log scan:');
  if (errors.length === 0) {
    console.log('   no queue/send-message error lines found in selected window');
    return;
  }

  for (const event of errors.slice(-20)) {
    const ts = event.timestamp ? new Date(event.timestamp).toISOString() : 'unknown-time';
    const stream = event.logStreamName || 'unknown-stream';
    const line = (event.message || '').trim();
    console.log(`   [${ts}] [${stream}] ${line}`);
  }
}

function startDlqRedrive(region: string, queueUrl: string, dlqUrl: string): void {
  const sourceArn = queueArn(region, dlqUrl);
  const destinationArn = queueArn(region, queueUrl);

  const raw = runAwsJson([
    'sqs',
    'start-message-move-task',
    '--region',
    region,
    '--source-arn',
    sourceArn,
    '--destination-arn',
    destinationArn,
  ]) as {
    TaskHandle?: string;
  };

  console.log(`   redrive started: ${raw.TaskHandle || 'task-handle-unavailable'}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const queueUrl = asString(args['queue-url'] || process.env.QUEUE_URL);
  const dlqUrlRaw = asString(args['dlq-url'] || process.env.DLQ_URL);
  const dlqUrl = dlqUrlRaw || undefined;
  const region = asString(args.region || process.env.AWS_REGION || 'us-east-1');
  const logGroup = asString(args['log-group'] || process.env.LOG_GROUP || '/aws/ecs/relayer-channels-stg/task');

  const phase = asString(args.phase || process.env.PHASE || 'full').toLowerCase();
  const trigger = asString(args.trigger || process.env.TRIGGER || 'app').toLowerCase();
  const smokeArgs = asString(args['smoke-args'] || process.env.SMOKE_ARGS || '');
  const waitSeconds = asInt(args['wait-seconds'] || process.env.WAIT_SECONDS, 180);
  const pollSeconds = asInt(args['poll-seconds'] || process.env.POLL_SECONDS, 15);
  const messages = asInt(args.messages || process.env.MESSAGES, 5);
  const redrive = asBool(args.redrive || process.env.REDRIVE);
  const chaosId = asString(args['chaos-id'] || process.env.CHAOS_ID || `${Date.now()}`);

  if (!queueUrl) {
    console.error('❌ Missing --queue-url (or QUEUE_URL env)');
    process.exit(1);
  }

  if (phase === 'redrive' && !dlqUrl) {
    console.error('❌ --dlq-url is required for redrive phase');
    process.exit(1);
  }
  if ((phase === 'inject' || phase === 'full') && trigger === 'app' && !smokeArgs) {
    console.error('❌ Missing --smoke-args for app trigger mode');
    process.exit(1);
  }

  console.log('════════════════════════════════════════════════════════');
  console.log('  Channels SQS Chaos Test');
  console.log('════════════════════════════════════════════════════════');
  console.log(`phase=${phase} region=${region}`);
  console.log(`trigger=${trigger}`);
  console.log(`queue=${queueUrl}`);
  if (dlqUrl) console.log(`dlq=${dlqUrl}`);
  console.log(`logGroup=${logGroup}`);
  console.log(`chaosId=${chaosId}`);
  console.log('');

  const startTimeMs = Date.now() - 5000;

  if (phase === 'inject' || phase === 'full') {
    if (trigger === 'app') {
      console.log('Triggering traffic through app smoke script...');
      runSmoke(smokeArgs);
    } else {
      console.log(`Injecting ${messages} poison message(s) directly to source queue...`);
      sendPoisonMessages(region, queueUrl, messages, chaosId);
    }
    console.log('');
  }

  if (phase === 'observe' || phase === 'full') {
    console.log(`Observing queues/logs for ${waitSeconds}s (poll ${pollSeconds}s)...`);
    await observe(region, queueUrl, dlqUrl, logGroup, waitSeconds, pollSeconds, startTimeMs);
    console.log('');
  }

  if (phase === 'redrive' || (phase === 'full' && (redrive || Boolean(dlqUrl)))) {
    if (!dlqUrl) {
      console.log('Skipping redrive: no DLQ URL provided.');
    } else {
      console.log('Starting DLQ redrive...');
      startDlqRedrive(region, queueUrl, dlqUrl);
      console.log('');
    }
  }

  if (phase === 'full' && dlqUrl) {
    console.log('Post-redrive observation...');
    await observe(region, queueUrl, dlqUrl, logGroup, Math.min(waitSeconds, 120), pollSeconds, startTimeMs);
  }

  console.log('════════════════════════════════════════════════════════');
  console.log('✓ Chaos run complete');
  console.log('════════════════════════════════════════════════════════');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Chaos script failed: ${message}`);
  process.exit(1);
});
