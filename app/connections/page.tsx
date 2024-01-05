'use client';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
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
      <h2>Slack</h2>
      <Link
        href="https://zensync.vercel.app/api/v1/slack/auth/11111111-1111-1111-1111-111111111111/redirect"
        className={buttonVariants()}
      >
        Connect To Slack
      </Link>
      {slackOauthStatus === 'success' && (
        <div>Successfully connected to Slack.</div>
      )}
      {slackOauthStatus === 'error' && <div>Error: {message}</div>}

      <h2>Zendesk</h2>
      <Label htmlFor="text">Zendesk Email Address</Label>
      <Input type="text" id="zendesk-email" placeholder="Email Address" />

      <Label htmlFor="text">Zendesk API Key</Label>
      <Input type="text" id="zendesk-key" placeholder="API Key" />
      <Link href="/" className={buttonVariants()}>
        Test Connection
      </Link>
    </>
  );
}
