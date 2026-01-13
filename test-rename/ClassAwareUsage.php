<?php

namespace App\Test;

class ClassAwareUsage {
    public function testDifferentClasses() {
        // Variable type tracking - should only rename UserController::handle
        $user = new UserController();
        $user->handle(); // Should rename only if UserController::handle is renamed
        
        $order = new OrderController();
        $order->handle(); // Should NOT rename if UserController::handle is renamed
        
        // Static calls - class explicit
        UserController::staticHandle();  // Only renames if in UserController
        OrderController::staticHandle(); // Only renames if in OrderController
    }
}
