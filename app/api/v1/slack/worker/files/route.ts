import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, and } from 'drizzle-orm';
import {
  channel,
  SlackConnection,
  zendeskConnection,
  ZendeskConnection,
  conversation
} from '@/lib/schema';
import { SlackMessageData } from '@/interfaces/slack-api.interface';
import { verifySignatureEdge } from '@upstash/qstash/dist/nextjs';

export const runtime = 'edge';

const FILE_SHARE_PROCESSED = 'zensync:file_share_processed';

export const POST = verifySignatureEdge(handler);
async function handler(request: NextRequest) {
  const requestJson = await request.json();
  console.log(JSON.stringify(requestJson, null, 2));

  const base64Decoded = atob(requestJson.body);

  try {
    let responseJson = JSON.parse(base64Decoded);
    responseJson = responseJson.body;
    responseJson.event.subtype = FILE_SHARE_PROCESSED;

    console.log(JSON.stringify(responseJson, null, 2));

    return NextResponse.json(responseJson, { status: 200 });
  } catch (error) {
    console.error('Error parsing JSON:', error);
    return new NextResponse('Error parsing JSON', { status: 400 });
  }
}
