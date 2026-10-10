pub trait SupervisorOwnershipGuard: Send + Sync {
    fn is_held(&self) -> bool;
}
