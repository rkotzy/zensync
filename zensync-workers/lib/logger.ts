import { Env } from '@/interfaces/env.interface';
import { Logtail } from '@logtail/edge';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';

export async function logRequestAndResponse(
  request,
  response,
  duration,
  ctx,
  env: Env
) {
  try {
    const baseLogger = new Logtail(env.BETTER_STACK_SOURCE_TOKEN);
    const logger = baseLogger.withExecutionContext(ctx);
    // Extract and format request metadata
    const requestMetadata = buildMetadataFromHeaders(request.headers);

    // Build the log message according to the provided structure
    const eventBody = {
      request_id: request.headers.get('X-Request-ID'),
      message: `Request to ${request.url} completed with status ${response.status}`,
      dt: new Date().toISOString(),
      duration,
      metadata: {
        response: {
          status_code: response.status
        },
        request: {
          url: request.url,
          method: request.method,
          headers: requestMetadata,
          cf: request.cf
        }
      }
    };

    logger.info(JSON.stringify(eventBody));
  } catch (e) {
    // TODO: - Send to sentry
  }
}

// Helper function to format headers into a more friendly structure
function buildMetadataFromHeaders(headers) {
  const metadata = {};
  for (const [key, value] of headers) {
    metadata[key] = value;
  }
  return metadata;
}

// export function logJsonWithId(
//   request: Request,
//   requestJson: any,
//   logger: EdgeWithExecutionContext
// ) {
//   const eventBody = {
//     ...requestJson,
//     request_id: request.headers.get('X-Request-ID')
//   };
//   logger.info(JSON.stringify(eventBody));
// }

export function responseWithLogging(
  request: Request,
  requestJson: any,
  responseMessage: string | null,
  responseStatus: number,
  logger: EdgeWithExecutionContext
): Response {
  try {
    const requestMetadata = buildMetadataFromHeaders(request.headers);
    const eventBody = {
      request_id: request.headers.get('X-Request-ID'),
      dt: new Date().toISOString(),
      metadata: {
        response: {
          status_code: responseStatus,
          message: responseMessage
        },
        request: {
          url: request.url,
          method: request.method,
          headers: requestMetadata,
          cf: request.cf,
          body: requestJson
        }
      }
    };
    logger.info(JSON.stringify(eventBody));
    return new Response(responseMessage, { status: responseStatus });
  } catch (e) {
    logger.error(`Error in responseWithLogging: ${e}`);
    return new Response(responseMessage, { status: responseStatus });
  }
}
