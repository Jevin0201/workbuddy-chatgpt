export class BridgeError extends Error {
  constructor(message, status = 400, code = 'invalid_request_error') {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
  }
}
