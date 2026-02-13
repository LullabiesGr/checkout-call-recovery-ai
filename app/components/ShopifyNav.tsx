import { NavMenu } from "@shopify/app-bridge-react";

export function ShopifyNav() {
  return (
    <NavMenu>
      <a href="/app">Dashboard</a>
      <a href="/app/checkouts">Checkouts</a>
      <a href="/app/calls">Calls</a>
      <a href="/app/additional">Settings</a>
    </NavMenu>
  );
}
