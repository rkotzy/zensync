import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
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

  // Your existing logic for other types of requests
  return NextResponse.json(
    {
      body: request.body,
      query: request.nextUrl.search,
      cookies: request.cookies.getAll()
    },
    {
      status: 200
    }
  );
}
