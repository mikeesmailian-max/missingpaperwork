import CarrierSubmission from "./submission";

export default async function SubmitPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <CarrierSubmission token={token} />;
}
