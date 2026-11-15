/** Agent `command.ack`/`command.result` rad etildi (noma'lum/begona buyruq): agent kanalida `nack(invalid_payload, retriable=false)`. */
export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}
