import type { Metadata } from "next";
import MyTodos from "@/components/todos/MyTodos";

export const metadata: Metadata = {
  title: "My to-dos · Markdrop",
  robots: { index: false, follow: false },
};

/** You › My to-dos: your to-do page in each of your teams (components/todos). */
export default function TodosPage() {
  return <MyTodos />;
}
