'use client';
import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { buttonVariants } from '@/components/ui/button';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export default function ConnectionsPage() {
  const [zendeskConnectionMessage, setMessage] = useState<string>('');
  const searchParams = useSearchParams();

  const slackOauthStatus = searchParams.get('slackOauth');
  const slackConnectionMessage = searchParams.get('message');

  const connectZendesk = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();

    console.log('Connecting to Zendesk');

    const zendeskDomain = (
      document.getElementById('zendesk-org') as HTMLInputElement
    ).value;
    const zendeskEmail = (
      document.getElementById('zendesk-email') as HTMLInputElement
    ).value;
    const zendeskKey = (
      document.getElementById('zendesk-key') as HTMLInputElement
    ).value;

    try {
      const response = await fetch('/api/v1/zendesk/auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ zendeskDomain, zendeskEmail, zendeskKey })
      });

      const data = await response.json();
      console.log(data);
      if (response.ok) {
        setMessage('Connection successful');
      } else {
        setMessage(`Connection failed: ${data.message}`);
      }
    } catch (error) {
      setMessage(
        `Connection failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  };

  return (
    <>
      <h1>Connections</h1>
      <h2>Slack</h2>
      <Link
        href="/api/v1/slack/auth/11111111-1111-1111-1111-111111111111/redirect" // TODO: - Get this from user session
        className={buttonVariants()}
        prefetch={false}
      >
        Connect To Slack
      </Link>
      {slackOauthStatus === 'success' && (
        <div>Successfully connected to Slack.</div>
      )}
      {slackOauthStatus === 'error' && (
        <div>Error: {slackConnectionMessage}</div>
      )}

      <h2>Zendesk</h2>
      <Label htmlFor="text">Organization Name</Label>
      <Input type="text" id="zendesk-org" placeholder="Domain" />

      <Label htmlFor="text">Zendesk Email Address</Label>
      <Input type="text" id="zendesk-email" placeholder="Email Address" />

      <Label htmlFor="text">Zendesk API Key</Label>
      <Input type="text" id="zendesk-key" placeholder="API Key" />
      <Link
        href="#"
        onClick={connectZendesk}
        className={buttonVariants()}
        prefetch={false}
      >
        Test Connection
      </Link>
      {zendeskConnectionMessage && <div>{zendeskConnectionMessage}</div>}
    </>
  );
}
