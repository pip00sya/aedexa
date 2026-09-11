import type { Metadata } from "next";
import AuthForm from "../components/auth/AuthForm";

export const metadata: Metadata = {
  title: "AEDEXA — вход",
  description: "Вход в рабочую область AEDEXA.",
};

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
