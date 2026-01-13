<?php

namespace App\Test;

class TestClass {
    public function oldMethod() {
        return 'test';
    }
    
    public function caller() {
        return $this->oldMethod();
    }
    
    public static function staticMethod() {
        return 'static';
    }
}
