import type { Metadata } from "next";
import AuthForm from "../components/auth/AuthForm";

export const metadata: Metadata = {
  title: "AEDEXA — создание аккаунта",
  description: "Аккаунт для переноса проектов между устройствами.",
};

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
