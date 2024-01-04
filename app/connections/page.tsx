import { getUser } from "../../auth";
import { buttonVariants } from "@/components/ui/button"
import Link from "next/link";


export default async function ConnectionsPage() {
  const { user } = await getUser();

  const userFields = user && [
    ["First name", user.firstName],
    ["Last name", user.lastName],
    ["Email", user.email],
    ["Id", user.id],
  ];

  return (
    <>
      <h1>Connections</h1>
      <Link href="https://zensync.vercel.app/api/v1/slack/auth/11111111-1111-1111-1111-111111111111/redirect"
      target="_blank" 
      rel="noopener noreferrer"
      className={buttonVariants({ variant: "outline" })}>Connect To Slack</Link>
    </>
  );
}