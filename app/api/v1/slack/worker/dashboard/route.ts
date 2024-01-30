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

  return new NextResponse('Ok', { status: 200 });
}