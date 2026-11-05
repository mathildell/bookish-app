import { redirect } from "next/navigation";

/** Legacy route — chat is unified on /chat now. Keeps old ?ids= links working. */
export default async function MultiChatPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  redirect(ids ? `/chat?ids=${ids}` : "/chat");
}
