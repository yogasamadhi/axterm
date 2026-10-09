import type { SftpHandle } from './ssh-transport';

export interface FtpFileHandle extends SftpHandle {
  pwd(): Promise<string>;
  cd(path: string): Promise<void>;
}

export interface FtpTransport {
  connect(input: {
    host: string;
    port: number;
    username: string;
    password?: string;
    security: 'plain' | 'explicit-tls' | 'implicit-tls';
    tlsVerify: boolean;
    encoding: 'utf-8' | 'gbk' | 'gb18030' | 'big5' | 'shift-jis' | 'euc-jp' | 'euc-kr';
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<FtpFileHandle>;
}
