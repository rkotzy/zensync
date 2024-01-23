import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import { zendeskConnection } from '@/lib/schema';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));

  // Save some database calls if it's a message from Zensync

  // Ignore messages from Zensync
  if (
    typeof requestBody.current_user_external_id === 'string' &&
    requestBody.current_user_external_id.startsWith('zensync')
  ) {
    console.log('Message from Zensync, skipping');
    return new NextResponse('Ok', { status: 200 });
  }

  // Ignore messages if last_updated_at === created_at
  if (requestBody.last_updated_at === requestBody.created_at) {
    console.log('Message is not an update, skipping');
    return new NextResponse('Ok', { status: 200 });
  }

  // Make sure we have the last updated ticket time
  const ticketLastUpdatedAt = requestBody.last_updated_at;
  if (!ticketLastUpdatedAt) {
    console.error('Missing last_updated_at');
    return new NextResponse('Missing last_updated_at', { status: 400 });
  }

  // Authenticate the request and get organization_id
  const organizationId = await authenticateRequest(request);
  if (!organizationId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // queue the message to be sent to slack
  try {
    const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
    await qstash.publishJSON({
      url: 'https://zensync.vercel.app/api/v1/zendesk/worker/messages',
      body: { eventBody: requestBody, organizationId: organizationId },
      headers: { 'x-ticket-updated-at': ticketLastUpdatedAt },
      contentBasedDeduplication: true
    });
  } catch (error) {
    console.error('Error publishing to qstash:', error);
    return new Response('Error queuing message', { status: 409 });
  }

  return new NextResponse('Accepted', { status: 202 });
}

async function authenticateRequest(
  request: NextRequest
): Promise<string | null> {
  const authorizationHeader = request.headers.get('authorization');
  const bearerToken = authorizationHeader?.replace('Bearer ', '');
  if (!bearerToken) {
    console.error('Missing bearer token');
    return null;
  }

  const connection = await db.query.zendeskConnection.findFirst({
    where: eq(zendeskConnection.id, bearerToken)
  });

  if (!connection) {
    console.error('Invalid bearer token');
    return null;
  }

  return connection.organizationId;
}
