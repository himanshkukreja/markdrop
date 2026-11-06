import AdminApp from "./AdminApp";

// No title of its own: to anyone who isn't an admin this address is an ordinary 404, so its HTML
// says nothing about an admin console (AdminApp sets the title once the console opens).
export const metadata = {
  robots: "noindex, nofollow",
};

export default function AdminPage() {
  return <AdminApp />;
}
