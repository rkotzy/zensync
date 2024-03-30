import { SlackResponse } from '@/interfaces/slack-api.interface';
import { ZendeskResponse } from '@/interfaces/zendesk-api.interface';
import { ZendeskConnection, SlackConnection } from '@/lib/schema';
import { fetchZendeskCredentials } from '@/lib/utils';
import { initializeDb } from '@/lib/drizzle';
import { Env } from '@/interfaces/env.interface';
import { Buffer } from 'node:buffer';

export async function uploadFilesToZendesk(requestJson: any, env: Env) {
  console.log('uploadFilesToZendesk', requestJson);

  let responseJson = requestJson;

  const slackRequestBody = requestJson.eventBody;
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    console.error('No connection details found');
    return;
  }

  // Handle an array of files here
  const slackFiles = slackRequestBody.event?.files || [];
  if (slackFiles.length === 0) {
    console.error('No file objects found in request body');
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
    console.error(error);
    throw new Error('Error fetching Zendesk credentials');
  }
  if (!zendeskCredentials) {
    console.log(
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
      slackFile = await getFileInfoFromSlack(connectionDetails, slackFile.id);
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
      console.error(error);
      throw new Error('Error uploading file to Zendesk');
    }

    // We intentionally fail here if a single upload token is missing and try them all again
    // It's easier to retry all uploads than to track which ones failed
    if (!uploadToken) {
      console.error('No upload token found');
      throw new Error('No upload token found');
    }

    zendeskFileTokens.push(uploadToken);
  }

  // Add the Zendesk upload tokens to the response
  responseJson.eventBody.zendeskFileTokens = zendeskFileTokens;

  try {
    await env.PROCESS_SLACK_MESSAGES_QUEUE_BINDING.send(responseJson);
  } catch (error) {
    console.error('Error publishing to message processing queue:', error);
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
    console.error(`Failed to upload to Zendesk:`, response);
    throw new Error(`Failed to upload to Zendesk`);
  }

  const data = (await response.json()) as ZendeskResponse;
  return data.upload.token;
}

async function getFileInfoFromSlack(
  slackConnection: SlackConnection,
  fileId: string
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

    if (!responseData.ok) {
      console.error(`Error getting Slack file info:`, responseData);
      throw new Error(`Error getting Slack file info: ${responseData.error}`);
    }
    return responseData.file;
  } catch (error) {
    console.error(`Error in getFileInfoFromSlack:`, error);
    throw error;
  }
}
