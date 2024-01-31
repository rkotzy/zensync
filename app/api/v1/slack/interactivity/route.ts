import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, is } from 'drizzle-orm';
import { slackConnection, SlackConnection } from '@/lib/schema';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Parse the request body
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));

  // Check if this is a URL verification request from Slack
  if (requestBody.type === 'url_verification') {
    // Respond with the challenge value
    return new Response(requestBody.challenge, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain'
      }
    });
  }

  new NextResponse('Ok', { status: 200 });
}
