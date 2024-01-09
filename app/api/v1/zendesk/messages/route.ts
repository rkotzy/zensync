import { NextResponse, NextRequest } from 'next/server';
import { db } from '@/lib/drizzle';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const requestBody = await request.json();
  console.log(JSON.stringify(requestBody, null, 2));
  // Your existing logic for other types of requests
  return NextResponse.json({ message: 'Ok' }, { status: 200 });
}
