import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  zendeskConnection,
  ZendeskConnection,
  SlackConnection
} from '@/lib/schema';
import { verifySignatureEdge } from '@upstash/qstash/dist/nextjs';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export const POST = verifySignatureEdge(handler);
async function handler(request: NextRequest) {
  const requestJson = await request.json();
  let responseJson = requestJson;
  console.log(JSON.stringify(requestJson, null, 2));

  const slackRequestBody = requestJson.eventBody;
  const connectionDetails: SlackConnection = requestJson.connectionDetails;
  if (!connectionDetails) {
    console.error('No connection details found');
    return new NextResponse('No connection details found.', { status: 500 });
  }

  // TODO: - Need to handle an array of files here
  // Check if a file object exists
  const slackFile = slackRequestBody.event?.files?.[0];
  if (!slackFile) {
    console.error('No file object found in request body');
    return new NextResponse('No file object found in request body', {
      status: 400
    });
  }

  // Fetch Zendesk credentials
  let zendeskCredentials: ZendeskConnection | null;
  try {
    zendeskCredentials = await fetchZendeskCredentials(
      connectionDetails.organizationId
    );
  } catch (error) {
    console.error(error);
    return new NextResponse('Error fetching Zendesk credentials', {
      status: 503
    });
  }
  if (!zendeskCredentials) {
    console.error(
      `No Zendesk credentials found for org: ${connectionDetails.organizationId}`
    );
    return new NextResponse('Error fetching Zendesk credentials', {
      status: 409
    });
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
    return new NextResponse('Error uploading file to Zendesk', {
      status: 409
    });
  }

  if (!uploadToken) {
    console.error('No upload token found');
    return new NextResponse('No upload token found', { status: 500 });
  }

  //!IMPORTANT - uncomment below line after testing
  //responseJson.eventBody.zendeskFileTokens = [uploadToken];

  console.log('Publishing to qstash:', responseJson);

  try {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
    await qstash.publishJSON({
      url: 'https://zensync.vercel.app/api/v1/slack/worker/messages',
      body: responseJson,
      contentBasedDeduplication: true
    });
  } catch (error) {
    console.error('Error publishing to qstash:', error);
    return new NextResponse('Internal Server Error', { status: 500 });
  }

  return new NextResponse('Ok', { status: 202 });
}

// TODO: - this is a duplicate of the one in zendesk/worker/messages/route.ts
async function fetchZendeskCredentials(
  organizationId: string
): Promise<ZendeskConnection | null> {
  const zendeskCredentials = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.organizationId, organizationId)
  });
  const zendeskDomain = zendeskCredentials?.zendeskDomain;
  const zendeskEmail = zendeskCredentials?.zendeskEmail;
  const zendeskApiKey = zendeskCredentials?.zendeskApiKey;

  if (!zendeskDomain || !zendeskEmail || !zendeskApiKey) {
    console.error(
      `Invalid Zendesk credentials found for organization ${organizationId}`
    );
    return null;
  }

  return zendeskCredentials;
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

  console.log(`Buffer size: ${fileBuffer.length} bytes`);
  console.log(`preparing to upload file type ${mimetype} to ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${zendeskAuthToken}`,
      'Content-Type': mimetype
    },
    body: fileBuffer
  });

  if (!response.ok) {
    console.error('Failed to upload to Zendesk:', await response.text());
    throw new Error(`Failed to upload to Zendesk: ${response}`);
  }

  const data = await response.json();
  console.log('Uploaded to Zendesk:', data);
  return data.upload.token;
}
