import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, is } from 'drizzle-orm';
import { slackConnection, SlackConnection } from '@/lib/schema';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Parse the request body
  const requestBody = await request.formData();
  const payloadString = requestBody.get('payload');

  // Make sure we have a payload
  if (typeof payloadString !== 'string') {
    return new NextResponse('Invalid payload', { status: 400 });
  }

  // Parse the JSON string into an object
  const payload = JSON.parse(payloadString);
  console.log(JSON.stringify(payload, null, 2));

  return new NextResponse('Ok', { status: 200 });
}
