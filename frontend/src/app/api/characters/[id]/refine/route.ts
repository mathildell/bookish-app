import { proxyStream } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyStream(`/api/characters/${encodeURIComponent(id)}/refine`)(request);
}
