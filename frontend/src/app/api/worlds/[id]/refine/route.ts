import { proxyStream } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyStream(`/api/worlds/${encodeURIComponent(id)}/refine`)(request);
}
