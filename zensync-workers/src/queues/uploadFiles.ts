import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { ZendeskConnection, SlackConnection } from '@/lib/schema-sqlite';
import { initializeDb, getZendeskCredentials } from '@/lib/database';
import { Env } from '@/interfaces/env.interface';
import { Buffer } from 'node:buffer';
import { safeLog } from '@/lib/logging';
import { getFileInfoFromSlack } from '@/lib/slack-api';

export async function uploadFilesToZendesk(requestJson: any, env: Env) {
  safeLog('log', 'uploadFilesToZendesk', requestJson);

  let responseJson = requestJson;

  const slackRequestBody = requestJson.eventBody;
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    safeLog('error', 'No connection details found');
    return;
  }

  // Handle an array of files here
  const slackFiles = slackRequestBody.event?.files || [];
  if (slackFiles.length === 0) {
    safeLog('error', 'No file objects found in request body');
    return;
  }

  const db = initializeDb(env);

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await getZendeskCredentials(
      db,
      env,
      connectionDetails.id
    );
  } catch (error) {
    safeLog('error', error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    safeLog(
      'log',
      `No Zendesk credentials found for slack connection: ${connectionDetails.id}`
    );
    return;
  }

  // Array to hold upload tokens for each file
  let zendeskFileTokens = [];

  for (let slackFile of slackFiles) {
    // Fetch Slack Connect file if needed
    // https://api.slack.com/apis/channels-between-orgs#check_file_info
    if (slackFile.id && slackFile.file_access === 'check_file_info') {
      slackFile = await getFileInfoFromSlack(
        connectionDetails.token,
        slackFile.id
      );
    }

    // Upload the file to Zendesk
    let uploadToken: string;
    try {
      uploadToken = await uploadFileFromUrlToZendesk(
        slackFile.url_private,
        slackFile.name,
        slackFile.mimetype,
        zendeskCredentials,
        connectionDetails
      );
    } catch (error) {
      safeLog('error', error);
      throw new Error('Error uploading file to Zendesk');
    }

    // We intentionally fail here if a single upload token is missing and try them all again
    // It's easier to retry all uploads than to track which ones failed
    if (!uploadToken) {
      safeLog('error', 'No upload token found');
      throw new Error('No upload token found');
    }

    zendeskFileTokens.push(uploadToken);
  }

  // Add the Zendesk upload tokens to the response
  responseJson.eventBody.zendeskFileTokens = zendeskFileTokens;

  try {
    await env.PROCESS_SLACK_MESSAGES_QUEUE_BINDING.send(responseJson);
  } catch (error) {
    safeLog('error', 'Error publishing to message processing queue:', error);
    throw new Error('Error publishing to queue');
  }
}

// Function to upload a file to Zendesk directly from a URL
async function uploadFileFromUrlToZendesk(
  fileUrl: string,
  fileName: string,
  mimetype: string,
  zendeskCredentials: ZendeskConnection,
  slackCredentials: SlackConnection
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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${zendeskAuthToken}`,
      'Content-Type': mimetype
    },
    body: fileBuffer
  });

  if (!response.ok) {
    safeLog('error', `Failed to upload to Zendesk:`, response);
    throw new Error(`Failed to upload to Zendesk`);
  }

  const data = (await response.json()) as ZendeskResponse;
  return data.upload.token;
}
