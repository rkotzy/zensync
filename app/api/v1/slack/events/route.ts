import { NextResponse, NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/lib/drizzle';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Retrieve the Slack signing secret
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;

  // Verify the Slack request
  if (!(await verifySlackRequest(request, signingSecret))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

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

async function verifySlackRequest(
  request: NextRequest,
  signingSecret: string
): Promise<boolean> {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const slackSignature = request.headers.get('x-slack-signature');
  const body = await request.text();

  const basestring = `v0:${timestamp}:${body}`;
  const mySignature =
    'v0=' +
    crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');

  // Convert both signatures to Buffer
  const slackSignatureBuffer = Buffer.from(slackSignature || '', 'utf8');
  const mySignatureBuffer = Buffer.from(mySignature, 'utf8');

  // Check if the signature length is equal to avoid timingSafeEqual throwing an error
  if (slackSignatureBuffer.length !== mySignatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(slackSignatureBuffer, mySignatureBuffer);
}
