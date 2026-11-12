import { proxyStream } from "@/lib/backendProxy";

export const dynamic = "force-dynamic";
export const POST = proxyStream("/api/characters/discover");
