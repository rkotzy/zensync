import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { ZendeskConnection, SlackConnection } from '@/lib/schema';
import { fetchZendeskCredentials } from '@/lib/utils';
import { initializeDb } from '@/lib/drizzle';
import { Env } from '@/interfaces/env.interface';
import { EdgeWithExecutionContext } from '@logtail/edge/dist/es6/edgeWithExecutionContext';
import { Buffer } from 'node:buffer';

export async function uploadFilesToZendesk(
  requestJson: any,
  env: Env,
  logger: EdgeWithExecutionContext
) {
  let responseJson = requestJson;
  logger.info(JSON.stringify(requestJson, null, 2));

  const slackRequestBody = requestJson.eventBody;
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    logger.error('No connection details found');
    return;
  }

  // Handle an array of files here
  const slackFiles = slackRequestBody.event?.files || [];
  if (slackFiles.length === 0) {
    logger.error('No file objects found in request body');
    return;
  }

  const db = initializeDb(env);

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await fetchZendeskCredentials(
      connectionDetails.id,
      db,
      env
    );
  } catch (error) {
    logger.error(error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    logger.error(
      `No Zendesk credentials found for slack connection: ${connectionDetails.id}`
    );
    throw new Error('No Zendesk credentials found');
  }

  // Array to hold upload tokens for each file
  let zendeskFileTokens = [];

  for (let slackFile of slackFiles) {
    // Fetch Slack Connect file if needed
    // https://api.slack.com/apis/channels-between-orgs#check_file_info
    if (slackFile.id && slackFile.file_access === 'check_file_info') {
      logger.info('Fetching file info from Slack');
      slackFile = await getFileInfoFromSlack(
        connectionDetails,
        slackFile.id,
        logger
      );
    }

    logger.info('Slack file to upload:', slackFile);

    // Upload the file to Zendesk
    let uploadToken: string;
    try {
      uploadToken = await uploadFileFromUrlToZendesk(
        slackFile.url_private,
        slackFile.name,
        slackFile.mimetype,
        zendeskCredentials,
        connectionDetails,
        logger
      );
    } catch (error) {
      logger.error(error);
      throw new Error('Error uploading file to Zendesk');
    }

    // We intentionally fail here if a single upload token is missing and try them all again
    if (!uploadToken) {
      logger.error('No upload token found');
      throw new Error('No upload token found');
    }

    zendeskFileTokens.push(uploadToken);
  }

  // Add the Zendesk upload tokens to the response
  responseJson.eventBody.zendeskFileTokens = zendeskFileTokens;

  logger.info('Publishing to queue:', responseJson);

  try {
    await env.PROCESS_SLACK_MESSAGES_QUEUE_BINDING.send(responseJson);
  } catch (error) {
    logger.error('Error publishing to queue:', error);
    throw new Error('Error publishing to queue');
  }

  logger.info('Published to qstash');
}

// Function to upload a file to Zendesk directly from a URL
async function uploadFileFromUrlToZendesk(
  fileUrl: string,
  fileName: string,
  mimetype: string,
  zendeskCredentials: ZendeskConnection,
  slackCredentials: SlackConnection,
  logger: EdgeWithExecutionContext
): Promise<string> {
  const fileResponse = await fetch(fileUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${slackCredentials.token}`
    }
  });
  if (!fileResponse.ok) {
    throw new Error(`Error fetching file: ${fileResponse.statusText}`);
  }
  const arrayBuffer = await fileResponse.arrayBuffer();
  const fileBuffer = Buffer.from(arrayBuffer);

  const url = `https://${
    zendeskCredentials.zendeskDomain
  }.zendesk.com/api/v2/uploads.json?filename=${encodeURIComponent(fileName)}`;

  const zendeskAuthToken = btoa(
    `${zendeskCredentials.zendeskEmail}/token:${zendeskCredentials.zendeskApiKey}`
  );

  logger.info(`Buffer size: ${fileBuffer.length} bytes`);
  logger.info(`preparing to upload file type ${mimetype} to ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${zendeskAuthToken}`,
      'Content-Type': mimetype
    },
    body: fileBuffer
  });

  if (!response.ok) {
    logger.error(`Failed to upload to Zendesk: ${await response.text()}`);
    throw new Error(`Failed to upload to Zendesk: ${response}`);
  }

  const data = (await response.json()) as ZendeskResponse;
  logger.info('Uploaded to Zendesk:', data);
  return data.upload.token;
}

async function getFileInfoFromSlack(
  slackConnection: SlackConnection,
  fileId: string,
  logger: EdgeWithExecutionContext
): Promise<any> {
  try {
    const response = await fetch(
      `https://slack.com/api/files.info?file=${fileId}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${slackConnection.token}`
        }
      }
    );

    const responseData = (await response.json()) as SlackResponse;

    logger.info(`Slack file info response: ${JSON.stringify(responseData)}`);

    if (!responseData.ok) {
      throw new Error(`Error getting Slack file info: ${responseData.error}`);
    }
    return responseData.file;
  } catch (error) {
    logger.error('Error in getFileInfoFromSlack:', error);
    throw error;
  }
}
