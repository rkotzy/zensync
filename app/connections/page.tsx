import { getUser } from "../../auth";

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
    </>
  );
}