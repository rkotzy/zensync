import { Env } from '@/interfaces/env.interface';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';

export async function slackConnectionCreated(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  logger.info(JSON.stringify(requestJson, null, 2));
}
