import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfilePatch,
} from '@workspace/contracts';
import type { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';

export class ConnectionProfileService {
  constructor(private readonly repository: ConnectionProfileRepository) {}

  list(): ConnectionProfile[] {
    return this.repository.list();
  }

  get(id: string): ConnectionProfile {
    return this.repository.get(id);
  }

  create(input: ConnectionProfileInput): ConnectionProfile {
    return this.repository.create(input);
  }

  update(
    id: string,
    input: ConnectionProfilePatch,
    ifMatch: string | undefined,
  ): ConnectionProfile {
    return this.repository.update(id, input, ifMatch);
  }

  delete(id: string, ifMatch: string | undefined): ConnectionProfile {
    return this.repository.delete(id, ifMatch);
  }
}

export function connectionProfileCredentialRefs(profile: ConnectionProfile): string[] {
  return [
    profile.ssh.passwordCredentialRef,
    profile.ssh.privateKeyCredentialRef,
    profile.ssh.passphraseCredentialRef,
    profile.ssh.certificateCredentialRef,
    profile.telnet.passwordCredentialRef,
    profile.vnc.passwordCredentialRef,
    profile.rdp.passwordCredentialRef,
    profile.ftp.passwordCredentialRef,
    profile.spice.passwordCredentialRef,
  ].filter((value): value is string => !!value);
}
