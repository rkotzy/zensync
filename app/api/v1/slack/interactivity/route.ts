import { NextResponse, NextRequest } from 'next/server';
import { verifySlackRequest } from '@/lib/utils';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  // Parse the request body
  const textClone = request.clone();

  // Verify the Slack request
  if (!(await verifySlackRequest(textClone))) {
    console.warn('Slack verification failed!');
    return new Response('Verification failed', { status: 200 });
  }

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

async function openZendeskConfigurationModal() {
  
}
