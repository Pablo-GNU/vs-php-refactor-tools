<?php

namespace App\Test;

class TestUsage {
    public function useTestClass() {
        $obj = new TestClass();
        $result = $obj->oldMethod();
        
        $static = TestClass::staticMethod();
        
        return $result . $static;
    }
}
