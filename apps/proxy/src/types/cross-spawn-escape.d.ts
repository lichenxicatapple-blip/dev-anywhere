declare module "cross-spawn/lib/util/escape.js" {
  const escape: {
    command(value: string): string;
    argument(value: string, doubleEscapeMetaChars: boolean): string;
  };
  export default escape;
}
