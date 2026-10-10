export interface ManagedContender {
  id: string;
  claimed: boolean;
}

export class DuplicateOwnershipDetector {
  private activeOwner: string | null = null;

  tryClaim(ownerId: string): boolean {
    if (this.activeOwner !== null && this.activeOwner !== ownerId) {
      return false;
    }
    this.activeOwner = ownerId;
    return true;
  }

  release(ownerId: string): void {
    if (this.activeOwner === ownerId) {
      this.activeOwner = null;
    }
  }

  getOwner(): string | null {
    return this.activeOwner;
  }
}
