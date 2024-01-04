'use client';

import { buttonVariants } from '@/components/ui/button';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export default function ConnectionsPage() {
  const searchParams = useSearchParams();

  const slackOauthStatus = searchParams.get('slackOauth');
  const message = searchParams.get('message');

  return (
    <>
      <h1>Connections</h1>
      <Link
        href="https://zensync.vercel.app/api/v1/slack/auth/11111111-1111-1111-1111-111111111111/redirect"
        className={buttonVariants({ variant: 'outline' })}
      >
        Connect To Slack
      </Link>
      {slackOauthStatus === 'success' && (
        <div>Successfully connected to Slack.</div>
      )}
      {slackOauthStatus === 'error' && <div>Error: {message}</div>}
    </>
  );
}
