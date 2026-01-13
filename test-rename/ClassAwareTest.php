<?php

namespace App\Test;

class UserController {
    public function handle() {
        return 'user handle';
    }
    
    public function process() {
        // $this should only rename in UserController
        return $this->handle();
    }
}

class OrderController {
    public function handle() {
        return 'order handle';
    }
    
    public function execute() {
        // $this should only rename in OrderController, NOT affected by UserController rename
        return $this->handle();
    }
}
