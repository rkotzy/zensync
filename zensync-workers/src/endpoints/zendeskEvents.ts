export const handler = async (request: Request): Promise<Response> => {
  return new Response('Hello, world!', { status: 200 });
};
