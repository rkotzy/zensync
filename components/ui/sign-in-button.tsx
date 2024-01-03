import { clearCookie, getAuthorizationUrl, getUser } from "../../auth";
import { Button } from "@/components/ui/button"
import Link from 'next/link'

export async function SignInButton({ large }: { large?: boolean }) {
  const { isAuthenticated } = await getUser();
  const authorizationUrl = await getAuthorizationUrl();

  if (isAuthenticated) {
    return (
        <form
          action={async () => {
            "use server";
            await clearCookie();
          }}
        >
          <Button type="submit">
            Sign Out
          </Button>
        </form>
    );
  }

  return (
    <Button asChild>
      <Link href={authorizationUrl}>Sign In {large && "with AuthKit"}</Link>
    </Button>
  );
}