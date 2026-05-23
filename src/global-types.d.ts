export {};

declare global {
  interface Request {
    json(): Promise<any>;
  }

  interface Response {
    json(): Promise<any>;
  }
}
