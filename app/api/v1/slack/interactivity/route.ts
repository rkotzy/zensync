import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';
import { eq, is } from 'drizzle-orm';
import { slackConnection, SlackConnection } from '@/lib/schema';
import { Client } from '@upstash/qstash';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Parse the request body
  const requestBody = await request.formData();
  console.log('requestBody', requestBody);
  const payload = requestBody.get('payload');
  console.log(JSON.stringify(payload, null, 2));

  new NextResponse('Ok', { status: 200 });
}
