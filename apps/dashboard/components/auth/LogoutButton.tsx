"use client";

import { useAuth } from "./AuthProvider";

export function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button type="button" className="nav w-full border-0 bg-transparent" style={{ font: "inherit", cursor: "pointer" }} onClick={() => void logout()}>
      <span aria-hidden="true">⎋</span>
      <span>Chiqish</span>
    </button>
  );
}
