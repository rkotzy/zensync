import "@radix-ui/themes/styles.css";
import { getUser } from "../../auth";
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"

export default async function AccountPage() {
  const { user } = await getUser();

  const userFields = user && [
    ["First name", user.firstName],
    ["Last name", user.lastName],
    ["Email", user.email],
    ["Id", user.id],
  ];

  return (
    <main className="w-full max-w-3xl py-12 px-4 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-50">Account Settings</h1>
      <form className="mt-6 space-y-8">
        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-50">Personal Information</h2>
          <div className="mt-6 grid grid-cols-1 gap-y-6 gap-x-4 sm:grid-cols-6">
            <div className="sm:col-span-6">
              <Label htmlFor="name">Name</Label>
              <Input id="name" placeholder="Enter your name" />
            </div>
            <div className="sm:col-span-6">
              <Label htmlFor="email">Email</Label>
              <Input id="email" placeholder="Enter your email" type="email" />
            </div>
            <div className="sm:col-span-6">
              <Label htmlFor="profile-picture">Profile Picture</Label>
              <Input id="profile-picture" type="file" />
            </div>
          </div>
        </section>
        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-50">Change Password</h2>
          <div className="mt-6 grid grid-cols-1 gap-y-6 gap-x-4 sm:grid-cols-6">
            <div className="sm:col-span-6">
              <Label htmlFor="current-password">Current Password</Label>
              <Input id="current-password" placeholder="Enter your current password" type="password" />
            </div>
            <div className="sm:col-span-6">
              <Label htmlFor="new-password">New Password</Label>
              <Input id="new-password" placeholder="Enter your new password" type="password" />
            </div>
            <div className="sm:col-span-6">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input id="confirm-password" placeholder="Confirm your new password" type="password" />
            </div>
          </div>
        </section>
        <section>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-50">Notification Preferences</h2>
          <div className="mt-6 grid grid-cols-1 gap-y-6 gap-x-4 sm:grid-cols-6">
            <div className="sm:col-span-6">
              <div>
                <div className="mr-4">Email Notifications</div>
                <Switch className="ml-auto" />
              </div>
            </div>
            <div className="sm:col-span-6">
              <div>
                <div className="mr-4">SMS Notifications</div>
                <Switch className="ml-auto" />
              </div>
            </div>
          </div>
        </section>
        <div className="flex justify-end space-x-4">
          <Button variant="outline">Cancel</Button>
          <Button>Save Changes</Button>
        </div>
      </form>
    </main>
  );
}